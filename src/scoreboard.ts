import { getScores, isCoFounder, makeScoreKey } from './router';
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

/**
 *
 * @param {Env} env
 * @returns {Promise<{myke: number, stephen: number} | undefined>} The up-to-date co-founder scores if any changed, or undefined if nothing changed
 */
export async function fetchStJudeScoreboard(env: Env): Promise<{ myke: number; stephen: number } | undefined> {
	const response = await fetch(env.ST_JUDE_SCOREBOARD_URL);
	if (!response.ok) {
		console.error(`St Jude scoreboard poll failed with status ${response.status}`);
		return undefined;
	}

	const data = await response.json();
	const scores: StJudeScoreboardResponse = stJudeScoreboardResponseSchema.parse(data);

	const coFounderEntries = scores.entries
		.map((entry) => ({ ...entry, name: entry.name.toLowerCase() }))
		.filter((entry): entry is typeof entry & { name: 'myke' | 'stephen' } => isCoFounder(entry.name));

	const updatedScores = await getScores(env);
	let changed = false;

	await Promise.all(coFounderEntries.map(async (entry) => {
		if (updatedScores[entry.name] !== entry.score) {
			await env.RELAY_FOR_ST_JUDE.put(makeScoreKey(entry.name), String(entry.score));
			updatedScores[entry.name] = entry.score;
			changed = true;
		}
	}));

	return changed ? updatedScores : undefined;
}
