import { isCoFounder, makeScoreKey } from './router';
import { z } from 'zod';

const stJudeScoreboardResponseSchema = z.object({
	entries: z.array(z.object({
		name: z.string(),
		score: z.number(),
		updatedAt: z.string(),
	})),
	fetchedAt: z.string(),
});

type StJudeScoreboardResponse = z.infer<typeof stJudeScoreboardResponseSchema>;

export async function fetchStJudeScoreboard(env: Env): Promise<void> {
	const response = await fetch(env.ST_JUDE_SCOREBOARD_URL);
	if (!response.ok) {
		console.error(`St Jude scoreboard poll failed with status ${response.status}`);
		return;
	}

	const data = await response.json();
	const scores: StJudeScoreboardResponse = stJudeScoreboardResponseSchema.parse(data);

	await Promise.all(scores.entries.map((entry) => {
		const name = entry.name.toLowerCase();
		if (!isCoFounder(name) || typeof entry.score !== 'number') {
			return Promise.resolve();
		}
		return env.RELAY_FOR_ST_JUDE.put(makeScoreKey(name), String(entry.score));
	}));
}
