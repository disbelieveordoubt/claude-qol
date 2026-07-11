// image-extractor.js — Auto-expands tool result blocks that contain generated images.
// MAIN world: intercepts fetch to mark image-containing tool results, uses ButtonBar for toggle.
// Two-mode approach: discovery (expand all, find images, mark, collapse all) then steady-state (keep marked expanded).
'use strict';

// ==== Preview dimension resolution ====
// msg.files no longer carries preview_asset dimensions, so we load the built preview
// URL and read its natural size. Persist the results in localStorage keyed by
// file_uuid so reloading a long conversation doesn't re-measure every image.
const _IMG_DIMS_CACHE_KEY = 'claude_qol_image_dims_cache';

const _imageDimsCache = (() => {
	try {
		const raw = localStorage.getItem(_IMG_DIMS_CACHE_KEY);
		return raw ? new Map(Object.entries(JSON.parse(raw))) : new Map();
	} catch (e) {
		return new Map();
	}
})();

function _persistImageDims() {
	try {
		localStorage.setItem(_IMG_DIMS_CACHE_KEY, JSON.stringify(Object.fromEntries(_imageDimsCache)));
	} catch (e) { /* quota or serialization issue — non-fatal */ }
}

function getImageDimensions(fileUuid, url) {
	const cached = _imageDimsCache.get(fileUuid);
	if (cached) return Promise.resolve(cached);

	return new Promise((resolve) => {
		const fallback = { width: 1024, height: 1024 };
		const img = new Image();
		let settled = false;
		const finish = (dims, persist) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (persist) {
				_imageDimsCache.set(fileUuid, dims);
				_persistImageDims();
			}
			resolve(dims);
		};
		// Don't cache the fallback — a later load may succeed with real dimensions.
		const timer = setTimeout(() => finish(fallback, false), 5000);
		img.onload = () => finish({
			width: img.naturalWidth || fallback.width,
			height: img.naturalHeight || fallback.height
		}, true);
		img.onerror = () => finish(fallback, false);
		img.src = url;
	});
}

// ==== LIVE SSE INJECTION ====
// During a streaming completion, MCP/ComfyUI image tools stream back as a bare
// tool_result content block (content: [{type:"image", file_uuid}, ...]) which the
// renderer draws as a tiny "Tool result" thumbnail. The renderer only draws a full
// gallery when a tool_result's name === "image_search", so — mirroring the load-time
// injector below — we splice a synthetic image_search tool_use + tool_result (carrying
// an image_gallery) into the stream right after each such block. Content blocks are
// keyed by a sequential integer index, so every later event's index is bumped by +2
// per injection. This is purely a live/visual upgrade; on reload the load-time path
// re-injects from the conversation JSON (with real measured dimensions).
function createImageInjectingStream(sourceBody, orgId) {
	const reader = sourceBody.getReader();
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();

	let buffer = '';
	let indexOffset = 0;
	const toolUseInputBuf = new Map();   // nativeIndex -> accumulated input_json_delta string
	const toolUseParsed = new Map();     // nativeIndex -> parsed tool_use input object
	const pendingInjections = new Map(); // tool_result nativeIndex -> [image items]

	const emit = (controller, text) => controller.enqueue(encoder.encode(text + '\n\n'));

	// Bump the single top-level "index":N in a passed-through event by the running offset.
	const applyOffset = (rawEvent) => {
		if (indexOffset === 0) return rawEvent;
		return rawEvent.replace(/"index":(\d+)/, (m, n) => `"index":${parseInt(n, 10) + indexOffset}`);
	};

	const buildInjectedEvents = async (toolResultNativeIndex, images, prompt) => {
		const outIndex = toolResultNativeIndex + indexOffset; // output index of the native tool_result we just emitted
		const toolUseIndex = outIndex + 1;
		const toolResultIndex = outIndex + 2;
		const toolUseId = 'toolu_gallery_' + crypto.randomUUID().replace(/-/g, '').substring(0, 20);
		const ts = new Date().toISOString();

		// Measure each preview (same helper + shared localStorage cache the load-time path
		// uses) so the gallery renders at the correct aspect immediately — no flash — and
		// so the later reload is instant. Width is scaled to 3840 so it renders full-width,
		// matching the load-time injector.
		const galleryImages = await Promise.all(images.map(async (c) => {
			const imageUrl = `https://claude.ai/api/${orgId}/files/${c.file_uuid}/preview`;
			const dims = await getImageDimensions(c.file_uuid, imageUrl);
			const scale = 3840 / dims.width;
			const scaledW = Math.round(dims.width * scale);
			const scaledH = Math.round(dims.height * scale);
			return {
				id: c.file_uuid,
				url: imageUrl,
				thumbnail_url: imageUrl,
				title: prompt ? 'Generated: ' + prompt.substring(0, 100) : '',
				source: '',
				page_url: imageUrl,
				width: scaledW,
				height: scaledH,
				thumbnail_width: scaledW,
				thumbnail_height: scaledH
			};
		}));

		const toolUseBlock = {
			type: 'content_block_start',
			index: toolUseIndex,
			content_block: {
				type: 'tool_use',
				id: toolUseId,
				name: 'image_search',
				input: {},
				message: 'Generated image' + (galleryImages.length > 1 ? 's' : ''),
				integration_name: null,
				integration_icon_url: null,
				icon_name: null,
				context: null,
				display_content: null,
				approval_options: null,
				approval_key: null,
				approval_key_legacy: null,
				is_mcp_app: null,
				mcp_server_url: null,
				start_timestamp: ts,
				stop_timestamp: null,
				flags: null
			}
		};

		const toolResultBlock = {
			type: 'content_block_start',
			index: toolResultIndex,
			content_block: {
				type: 'tool_result',
				tool_use_id: toolUseId,
				name: 'image_search',
				content: [
					{ text: prompt ? 'Generated image for: ' + prompt : 'Generated image', type: 'text' },
					{ type: 'image_gallery', images: galleryImages }
				],
				is_error: false,
				structured_content: null,
				meta: null,
				message: null,
				integration_name: null,
				mcp_server_url: null,
				integration_icon_url: null,
				icon_name: null,
				display_content: null,
				start_timestamp: ts,
				stop_timestamp: ts,
				flags: null
			}
		};

		return [
			`event: content_block_start\ndata: ${JSON.stringify(toolUseBlock)}`,
			`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: toolUseIndex, stop_timestamp: ts })}`,
			`event: content_block_start\ndata: ${JSON.stringify(toolResultBlock)}`,
			`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: toolResultIndex, stop_timestamp: ts })}`
		];
	};

	const handleEvent = async (controller, rawEvent) => {
		if (!rawEvent.trim()) return;

		let parsed = null;
		const dataMatch = rawEvent.match(/(?:^|\n)data: (.*)$/);
		if (dataMatch) { try { parsed = JSON.parse(dataMatch[1]); } catch (e) { /* non-JSON event */ } }

		// Forward the native event first, with any accumulated index offset applied.
		emit(controller, applyOffset(rawEvent));

		if (!parsed || typeof parsed.index !== 'number') return;

		// Accumulate the preceding tool_use's streamed input so we can recover its prompt.
		if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
			toolUseInputBuf.set(parsed.index, '');
		} else if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'input_json_delta' && toolUseInputBuf.has(parsed.index)) {
			toolUseInputBuf.set(parsed.index, toolUseInputBuf.get(parsed.index) + (parsed.delta.partial_json || ''));
		} else if (parsed.type === 'content_block_stop' && toolUseInputBuf.has(parsed.index)) {
			try { toolUseParsed.set(parsed.index, JSON.parse(toolUseInputBuf.get(parsed.index) || '{}')); } catch (e) {}
			toolUseInputBuf.delete(parsed.index);
		}

		// Detect a bare-image tool_result (ComfyUI/MCP). Native image_search results carry
		// an image_gallery instead of bare image items, so they never match.
		if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_result') {
			const images = (parsed.content_block.content || []).filter((c) => c.type === 'image' && c.file_uuid);
			if (images.length > 0 && orgId) pendingInjections.set(parsed.index, images);
		}

		// The tool_result start is immediately followed by its stop; inject right after it.
		if (parsed.type === 'content_block_stop' && pendingInjections.has(parsed.index)) {
			const images = pendingInjections.get(parsed.index);
			pendingInjections.delete(parsed.index);
			const prompt = toolUseParsed.get(parsed.index - 1)?.prompt || '';
			for (const ev of await buildInjectedEvents(parsed.index, images, prompt)) emit(controller, ev);
			indexOffset += 2;
		}
	};

	return new ReadableStream({
		async pull(controller) {
			while (true) {
				let result;
				try {
					result = await reader.read();
				} catch (e) {
					controller.error(e);
					return;
				}
				const { done, value } = result;
				if (done) {
					if (buffer.trim()) await handleEvent(controller, buffer);
					controller.close();
					return;
				}
				buffer += decoder.decode(value, { stream: true });
				let emitted = false;
				let boundary;
				while ((boundary = buffer.indexOf('\n\n')) !== -1) {
					const rawEvent = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary + 2);
					await handleEvent(controller, rawEvent);
					emitted = true;
				}
				if (emitted) return; // yield back to consumer after producing output
			}
		},
		cancel(reason) {
			try { reader.cancel(reason); } catch (e) {}
		}
	});
}

// ==== FETCH INTERCEPTION — inject test markers into tool_use/thinking near image results ====
const _imageExtractorOriginalFetch = window.fetch;
window.fetch = async (...args) => {
	const [input, config] = args;

	let url;
	if (input instanceof URL) url = input.href;
	else if (typeof input === 'string') url = input;
	else if (input instanceof Request) url = input.url;

	// Live streaming: inject galleries into the completion SSE stream as tool results arrive.
	if (url &&
		(url.includes('/completion') || url.includes('/retry_completion')) &&
		config?.method === 'POST') {

		const response = await _imageExtractorOriginalFetch(...args);
		if (!response.body) return response;

		let orgId = null;
		try { orgId = getOrgId(); } catch (e) { /* no org id → cannot build preview URLs */ }
		if (!orgId) return response;

		try {
			const transformed = createImageInjectingStream(response.body, orgId);
			return new Response(transformed, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers
			});
		} catch (e) {
			console.error('[QOL-ImageExtractor] Failed to wrap completion stream, passing through:', e);
			return response;
		}
	}

	if (url &&
		url.includes('/chat_conversations/') &&
		url.includes('rendering_mode=messages') &&
		(!config || config.method === 'GET' || !config.method)) {

		const response = await _imageExtractorOriginalFetch(...args);
		const data = await response.json();

		if (data?.chat_messages) {
			// Org ID for building preview URLs when msg.files is empty (new API shape).
			let orgId = null;
			try { orgId = getOrgId(); } catch (e) { /* fail soft — fall back to file URLs */ }

			for (const msg of data.chat_messages) {
				if (msg.sender === 'human') continue;
				const content = msg.content;
				if (!content) continue;

				// Build file lookup map (may be empty on the new API shape)
				const fileMap = new Map();
				for (const f of msg.files || []) {
					fileMap.set(f.file_uuid || f.uuid, f);
				}

				// Collect galleries to insert (process backwards to avoid index shift)
				const insertions = []; // { afterIndex, toolUse, toolResult }

				for (let i = 0; i < content.length; i++) {
					const item = content[i];
					if (item.type !== 'tool_result') continue;
					if (!item.content?.some(c => c.type === 'image')) continue;

					// Collect all image items from this tool_result. Resolve URL from the
					// file entry if present, otherwise build it ourselves, then measure
					// dimensions in parallel.
					const galleryImages = (await Promise.all(item.content.map(async (c) => {
						if (c.type !== 'image') return null;
						const file = fileMap.get(c.file_uuid);

						let imageUrl = file?.preview_url || file?.thumbnail_url;
						if (!imageUrl && orgId) {
							imageUrl = `https://claude.ai/api/${orgId}/files/${c.file_uuid}/preview`;
						}
						if (!imageUrl) return null; // no file entry and no orgId → cannot build

						// Prefer dimensions from the file asset; otherwise measure the preview.
						const asset = file?.preview_asset || file?.thumbnail_asset || {};
						let realW = asset.image_width;
						let realH = asset.image_height;
						if (!realW || !realH) {
							const dims = await getImageDimensions(c.file_uuid, imageUrl);
							realW = dims.width;
							realH = dims.height;
						}

						// Scale dimensions up so the gallery renders at full width
						const scale = 3840 / realW;
						const scaledW = Math.round(realW * scale);
						const scaledH = Math.round(realH * scale);

						return {
							id: c.file_uuid,
							url: imageUrl,
							thumbnail_url: imageUrl,
							title: "",
							source: "",
							page_url: imageUrl,
							width: scaledW,
							height: scaledH,
							thumbnail_width: scaledW,
							thumbnail_height: scaledH
						};
					}))).filter(Boolean);

					if (galleryImages.length === 0) continue;

					// Get prompt from preceding tool_use if available
					let prompt = "";
					const precedingToolUse = i > 0 && content[i - 1].type === 'tool_use' ? content[i - 1] : null;
					if (precedingToolUse?.input?.prompt) {
						prompt = precedingToolUse.input.prompt;
						galleryImages.forEach(img => img.title = "Generated: " + prompt.substring(0, 100));
					}

					const toolUseId = "toolu_gallery_" + crypto.randomUUID().replace(/-/g, '').substring(0, 20);
					const timestamp = new Date().toISOString();

					const galleryToolUse = {
						start_timestamp: timestamp,
						stop_timestamp: timestamp,
						type: "tool_use",
						id: toolUseId,
						name: "image_search",
						input: {},
						message: "Generated image" + (galleryImages.length > 1 ? "s" : "")
					};

					const galleryToolResult = {
						type: "tool_result",
						tool_use_id: toolUseId,
						name: "image_search",
						content: [
							{
								type: "text",
								text: prompt ? "Generated image for: " + prompt : "Generated image",
								uuid: crypto.randomUUID()
							},
							{
								type: "image_gallery",
								images: galleryImages,
								uuid: crypto.randomUUID(),
								is_expired: false
							}
						],
						is_error: false
					};

					insertions.push({ afterIndex: i, toolUse: galleryToolUse, toolResult: galleryToolResult });
				}

				// Apply insertions from end to start to preserve indices
				for (let j = insertions.length - 1; j >= 0; j--) {
					const { afterIndex, toolUse, toolResult } = insertions[j];

					// Find first text item after the tool_result
					let insertAt = -1;
					for (let k = afterIndex + 1; k < content.length; k++) {
						if (content[k].type === 'text') {
							insertAt = k;
							break;
						}
					}

					if (insertAt !== -1) {
						content.splice(insertAt, 0, toolUse, toolResult);
					} else {
						content.push(toolUse, toolResult);
					}
				}

				if (insertions.length > 0) {
					console.log('[QOL-ImageExtractor] Final content array for message', msg.uuid, JSON.parse(JSON.stringify(content)));
				}
			}
		}

		return new Response(JSON.stringify(data), {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers
		});
	}

	return _imageExtractorOriginalFetch(...args);
};

// Inject styles for tool result images displayed inside expanded blocks
(function () {
	const style = document.createElement('style');
	style.textContent = `
		[data-message-uuid] div.overflow-y-auto:has(img[alt="Tool result"]) {
			max-height: none !important;
			overflow: visible !important;
		}
		[data-message-uuid] img[alt="Tool result"] {
			max-width: 600px !important;
			max-height: none !important;
			width: 100% !important;
			border-radius: 8px;
		}
		/* Make injected inline image galleries full width */
		div.my-2 > button:has(> img[src*="/files/"][src$="/preview"]) {
			width: 85% !important;
			height: auto !important;
		}
		div.my-2 > button > img[src*="/files/"][src$="/preview"] {
			height: auto !important;
			object-fit: contain !important;
		}
	`;
	function appendStyle() {
		if (document.head) {
			document.head.appendChild(style);
			console.log('[QOL-ImageExtractor] Injected custom styles for tool result images.');
		} else {
			document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style));
		}
	}
	appendStyle();
})();
