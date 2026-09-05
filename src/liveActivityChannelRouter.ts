import { IRequestStrict, Router, StatusError } from 'itty-router';
import { z } from 'zod';
import { getOrCreateChannel, liveActivityChannelCacheTag } from './apns';
import { ONE_DAY, ONE_HOUR } from './constants';

type LiveActivityChannelRequest = Request & IRequestStrict;

const router = Router<LiveActivityChannelRequest, [Env, ExecutionContext]>({ base: '/api/live-activity-channel' });

const environmentSchema = z.enum(['sandbox', 'production']);

router.get('/', async (request, env: Env, ctx: ExecutionContext) => {
	const url = new URL(request.url);
	const environmentResult = environmentSchema.safeParse(url.searchParams.get('environment'));
	if (!environmentResult.success) {
		throw new StatusError(422, environmentResult.error.message);
	}
	const environment = environmentResult.data;

	const channelId = await getOrCreateChannel(env, environment);

	return new Response(JSON.stringify({ channelId }), {
		headers: {
			'content-type': 'application/json',
			'cache-control': 'public, max-age=600',
			'cdn-cache-control': `public, max-age=${ONE_HOUR}, stale-while-revalidate=${ONE_DAY}`,
			'cache-tag': liveActivityChannelCacheTag(environment),
		},
	});
});

export default router;
