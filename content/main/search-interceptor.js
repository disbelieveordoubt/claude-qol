// search-interceptor.js
(function () {
	'use strict';

	const originalFetch = window.fetch;
	const pendingSearches = new Map();
	let messageIdCounter = 0;
	let lastSearchQuery = null; // Track latest search query

	// Listen for responses from ISOLATED
	window.addEventListener('message', (event) => {
		if (event.source !== window) return;
		if (event.data.type !== 'SEARCH_RESPONSE') return;

		const { messageId, intercept, results } = event.data;
		const resolver = pendingSearches.get(messageId);

		if (resolver) {
			resolver({ intercept, results });
			pendingSearches.delete(messageId);
		}
	});

	// Monkeypatch fetch
	window.fetch = async function (...args) {
		const [input, config] = args;

		let url;
		if (input instanceof URL) {
			url = input.href;
		} else if (typeof input === 'string') {
			url = input;
		} else if (input instanceof Request) {
			url = input.url;
		}

		// Check if this is a conversation search request
		if (url && url.includes('/conversation/search')) {
			const urlObj = new URL(url, window.location.origin);
			const searchQuery = urlObj.searchParams.get('query');
			lastSearchQuery = searchQuery; // Store the query

			if (searchQuery) {
				//console.log('[QOL-SearchInterceptor] Detected search query:', searchQuery);

				// Ask ISOLATED if we should intercept
				const messageId = messageIdCounter++;

				const responsePromise = new Promise((resolve) => {
					pendingSearches.set(messageId, resolve);

					// Timeout after 30 seconds
					setTimeout(() => {
						if (pendingSearches.has(messageId)) {
							console.warn('[QOL-SearchInterceptor] Timeout waiting for ISOLATED response');
							resolve({ intercept: false });
							pendingSearches.delete(messageId);
						}
					}, 30000);
				});

				window.postMessage({
					type: 'SEARCH_INTERCEPT',
					messageId,
					query: searchQuery,
					url: url
				}, '*');

				const response = await responsePromise;

				if (response.intercept) {
					console.log('[QOL-SearchInterceptor] Intercepting with custom results:', JSON.stringify(response.results));

					// Return fake Response with our results
					return new Response(JSON.stringify({data: response.results, has_more: false}), {
						status: 200,
						statusText: 'OK',
						headers: {
							'Content-Type': 'application/json'
						}
					});
				} else {
					//console.log('[QOL-SearchInterceptor] Passing through to original fetch');
				}
			}
		}

		// Not a search request, or ISOLATED said don't intercept - use original fetch
		return originalFetch.apply(this, args);
	};

	// When a search result is clicked, remember the query for that conversation so the in-chat
	// search auto-opens and highlights it on arrival. Delegated (capture phase) so it doesn't
	// depend on the result's DOM text: in the v2 results table the conversation link is an empty
	// overlay (title/snippet live in separate cells), so the old "(N matches)" text filter no
	// longer matches anything. We identify result links structurally instead (inside the results
	// <table>), which excludes the always-present sidebar /chat/ links.
	document.addEventListener('click', (event) => {
		if (!window.location.pathname.includes('/recents') && !window.location.pathname.includes('/chats')) return;
		if (sessionStorage.getItem('text_search_enabled') !== 'true') return;
		if (!lastSearchQuery) return;

		const target = event.target instanceof Element ? event.target : event.target?.parentElement;
		const link = target ? target.closest('a[href^="/chat/"]') : null;
		if (!link || !link.closest('table')) return; // results live in a table; sidebar links don't

		const match = link.getAttribute('href').match(/\/chat\/([a-f0-9-]+)/);
		if (!match) return;

		const conversationId = match[1];
		const queries = JSON.parse(localStorage.getItem('global_search_queries') || '{}');
		queries[conversationId] = lastSearchQuery;
		localStorage.setItem('global_search_queries', JSON.stringify(queries));
		console.log('[QOL-SearchInterceptor] Stored query for conversation:', conversationId);
	}, true);

	console.log('[QOL-SearchInterceptor] Installed');
})();