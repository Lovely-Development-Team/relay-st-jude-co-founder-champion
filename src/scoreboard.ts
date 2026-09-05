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

export async function fetchStJudeScoreboard(env: Env): Promise<boolean> {
	const response = await fetch(env.ST_JUDE_SCOREBOARD_URL);
	if (!response.ok) {
		console.error(`St Jude scoreboard poll failed with status ${response.status}`);
		return false;
	}

	const data = await response.json();
	const scores: StJudeScoreboardResponse = stJudeScoreboardResponseSchema.parse(data);

	const coFounderEntries = scores.entries
		.map((entry) => ({ ...entry, name: entry.name.toLowerCase() }))
		.filter((entry) => isCoFounder(entry.name));

	const previousStrings = await env.RELAY_FOR_ST_JUDE.get(coFounderEntries.map((entry) => makeScoreKey(entry.name)));

	const results = await Promise.all(coFounderEntries.map(async (entry) => {
		const key = makeScoreKey(entry.name);
		const previousString = previousStrings.get(key) ?? null;
		const previous = previousString !== null ? Number.parseFloat(previousString) : null;

		if (previous !== entry.score) {
			await env.RELAY_FOR_ST_JUDE.put(key, String(entry.score));
			return true;
		}
		return false;
	}));

	return results.some(r=> r);
}
