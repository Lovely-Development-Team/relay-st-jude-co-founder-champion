import { IRequestStrict, Router, status, StatusError } from 'itty-router';
import { notifyScoreChange } from './apns';
import { checkAuthentication } from './auth';
import liveActivityRouter from './liveActivityRouter';
import liveActivityChannelRouter from './liveActivityChannelRouter';
import { ONE_DAY, ONE_HOUR } from './constants';

// Barring a dramatic upheaval, I think we're safe to hardcode this.
export const CO_FOUNDERS = ['myke', 'stephen'] as const;

type ScoreRequest = Request & IRequestStrict & { coFounder?: typeof CO_FOUNDERS[number] }

// now let's create a router (note the lack of "new")
const router = Router<ScoreRequest, [Env, ExecutionContext]>();

export function makeScoreKey(coFounder: string | undefined) {
	return `score|${coFounder}`;
}

export const CO_FOUNDER_SCORES_CACHE_TAG = 'co-founder-scores';

router.get('/api/co-founders', async (request, env: Env, ctx: ExecutionContext) => {
	const [mykeScoreString, stephenScoreString] = await Promise.all(
		[env.RELAY_FOR_ST_JUDE.get(makeScoreKey('myke')),
			env.RELAY_FOR_ST_JUDE.get(makeScoreKey('stephen'))]
	);
	const mykeScore = mykeScoreString !== null ? Number.parseFloat(mykeScoreString) : 0;
	const stephenScore = stephenScoreString !== null ? Number.parseFloat(stephenScoreString) : 0;
	return new Response(JSON.stringify({
		myke: { score: mykeScore },
		stephen: { score: stephenScore },
	}), {
		headers: {
			'content-type': 'application/json',
			'cache-control': 'public, max-age=300',
			'cdn-cache-control': `public, max-age=${ONE_HOUR}, stale-while-revalidate=${ONE_DAY}`,
			'cache-tag': CO_FOUNDER_SCORES_CACHE_TAG,
		},
	});
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

router.get('/api/co-founders/:cofounder', checkCoFounder, async (request, env: Env, ctx: ExecutionContext) => {
	const stringScore = await env.RELAY_FOR_ST_JUDE.get(makeScoreKey(request.coFounder));
	const score = stringScore !== null ? Number.parseFloat(stringScore) || 0 : 0;
	return new Response(JSON.stringify({ score }), {
		headers: {
			'content-type': 'application/json',
			'cache-control': 'public, max-age=300',
			'cdn-cache-control': `public, max-age=${ONE_HOUR}, stale-while-revalidate=${ONE_DAY}`,
			'cache-tag': CO_FOUNDER_SCORES_CACHE_TAG,
		},
	});
});

router.put('/api/co-founders/:cofounder', checkAuthentication, checkCoFounder, async (request, env: Env, ctx: ExecutionContext) => {
	const body = await request.json<{ score?: unknown }>();
	// Empty strings and non-existent values are disallowed, but zero is allowed
	if (!body.score && body.score != 0) {
		throw new StatusError(422, 'Updates must include a score');
	}
	if (!(typeof body.score === 'number')) {
		throw new StatusError(422, 'Scores must be a number');
	}
	await env.RELAY_FOR_ST_JUDE.put(makeScoreKey(request.coFounder), String(body.score));

	// KV reads can lag behind writes (eventual
	// consistency), so don't re-read it from KV a moment later. The other co-founder's
	// score wasn't just written, so it's safe to read from KV.
	const otherCoFounder = CO_FOUNDERS.find((name) => name !== request.coFounder)!;
	const otherScoreString = await env.RELAY_FOR_ST_JUDE.get(makeScoreKey(otherCoFounder));
	const otherScore = otherScoreString !== null ? Number.parseFloat(otherScoreString) : 0;

	const scores = { myke: 0, stephen: 0 };
	scores[request.coFounder!] = body.score;
	scores[otherCoFounder] = otherScore;

	// notifyScoreChange also purges the co-founder-scores cache tag, since both this handler
	// and the cron-driven scoreboard sync call it whenever a score actually changes.
	ctx.waitUntil(notifyScoreChange(env, scores).catch((err) => {
		console.error('Failed to send push notifications', err);
	}));

	return status(204);
});

router.all('/api/push-tokens/*', liveActivityRouter.handle);
router.all('/api/live-activity-channel', liveActivityChannelRouter.handle);

// 404 for everything else
router.all('*', () => {
	throw new StatusError(404, ' Not Found.');
});

export default router;
