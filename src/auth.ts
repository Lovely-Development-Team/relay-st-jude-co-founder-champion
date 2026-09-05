import { StatusError } from 'itty-router';

function checkBearerToken(request: Request, expectedToken: string) {
	const authHeader = request.headers.get("authorization");
	if (!authHeader || !authHeader.startsWith("Bearer ")) {
		throw new StatusError(401);
	}
	const token = authHeader.substring(7, authHeader.length);
	if (token !== expectedToken) {
		throw new StatusError(403);
	}
}

export function checkAuthentication(request: Request, env: Env) {
	checkBearerToken(request, env.ST_JUDE_SCOREBOARD_KEY);
}

export function checkPushTokenAuthentication(request: Request, env: Env) {
	checkBearerToken(request, env.PUSH_TOKEN_UPDATE_KEY);
}
