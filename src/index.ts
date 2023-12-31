/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import apiRouter from './router';
import { error, json } from 'itty-router';

// Export a default object containing event handlers
export default {
	// The fetch handler is invoked when this worker receives a HTTP(S) request
	// and should return a Response (optionally wrapped in a Promise)
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// You'll find it helpful to parse the request.url string into a URL object. Learn more at https://developer.mozilla.org/en-US/docs/Web/API/URL
		const url = new URL(request.url);

		if (url.pathname.startsWith('/api/')) {
			return apiRouter.handle(request, env).then(json).catch(error);
		}

		return new Response(
			`Try making requests to:
      <ul>
      <li><code><a href='/api/co-founders'>/api/co-founders</a></code>,</li>
      <li><code><a href='/api/co-founders/myke'>/api/co-founders/myke</a></code>,</li>
      <li><code><a href='/api/co-founders/stephen'>/api/co-founders/stephen</a></code>,</li>
      </ul>`,
			{ headers: { 'Content-Type': 'text/html' } }
		);
	}
};
