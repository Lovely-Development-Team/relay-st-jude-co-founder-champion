import { cache } from 'cloudflare:workers';

/**
 * Purges Workers Caching entries by tag. Never throws or rejects: a missing, rate-limited or failing
 * purge must not block the work that triggered it (push notifications, request responses).
 * The try/catch also covers `cache.purge` throwing synchronously (e.g. "cache.purge is not a function"),
 * which a `.catch()` chained onto the call would not catch.
 * @param tag The Cache-Tag to purge.
 * @param description What is being purged, used in log messages.
 */
export async function purgeCacheTag(tag: string, description: string): Promise<void> {
	try {
		const purgeResult = await cache.purge({ tags: [tag] });
		if (!purgeResult.success) {
			console.error(`Failed to purge ${description}`, purgeResult.errors);
		}
	} catch (err) {
		console.error(`Threw while purging ${description}: ${err instanceof Error ? err.message : String(err)}`);
	}
}
