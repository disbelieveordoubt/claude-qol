// background.js
if (typeof importScripts !== 'undefined') {
	importScripts('lib/jszip.min.js');
}

if (chrome.action) {
	chrome.action.onClicked.addListener((tab) => {
		chrome.tabs.create({ url: 'https://ko-fi.com/lugia19' });
	});
}

// Handle GDPR export download
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (message.type === 'DOWNLOAD_GDPR_EXPORT') {
		console.log('[Background] Downloading GDPR export:', message.url);

		(async () => {
			try {
				const response = await fetch(message.url);
				if (!response.ok) {
					throw new Error(`Download failed: ${response.status}`);
				}

				const arrayBuffer = await response.arrayBuffer();
				console.log('[Background] Downloaded', arrayBuffer.byteLength, 'bytes');

				let conversations;

				try {
					// Try as multi-file JSON manifest first
					const text = new TextDecoder().decode(arrayBuffer);
					const manifest = JSON.parse(text);

					if (!manifest.data_files) throw new Error('Not a manifest');

					console.log('[Background] Got multi-file manifest with', manifest.data_files.length, 'files');
					const sortedFiles = manifest.data_files.sort((a, b) => a.batch_index - b.batch_index);
					conversations = [];

					for (const file of sortedFiles) {
						console.log('[Background] Downloading batch', file.batch_index);

						// Fetch the export page to get the actual storage URL
						const pageResponse = await fetch(file.export_url);
						if (!pageResponse.ok) {
							throw new Error(`Batch ${file.batch_index} page failed: ${pageResponse.status}`);
						}
						const html = await pageResponse.text();
						const urlMatch = html.match(/https:\/\/storage\.googleapis\.com\/user-data-export-production\/[^"]+/);
						if (!urlMatch) {
							throw new Error(`Batch ${file.batch_index}: no storage URL found in export page`);
						}
						const storageUrl = urlMatch[0].replace(/\\u0026/g, '&');

						// Download the actual ZIP from storage
						const zipResponse = await fetch(storageUrl);
						if (!zipResponse.ok) {
							throw new Error(`Batch ${file.batch_index} download failed: ${zipResponse.status}`);
						}
						const zipBuffer = await zipResponse.arrayBuffer();
						const zip = await JSZip.loadAsync(zipBuffer);
						const conversationsFile = zip.file('conversations.json');
						if (!conversationsFile) {
							throw new Error(`conversations.json not found in batch ${file.batch_index}`);
						}
						const jsonText = await conversationsFile.async('text');
						const batch = JSON.parse(jsonText);
						conversations.push(...batch);
						console.log('[Background] Batch', file.batch_index, ':', batch.length, 'conversations');
					}
				} catch (jsonError) {
					console.warn('[Background] Not a multi-file manifest, trying as single ZIP:', jsonError);
					// Not a JSON manifest — treat as single ZIP
					const zip = await JSZip.loadAsync(arrayBuffer);
					console.log('[Background] Zip loaded, files:', Object.keys(zip.files));

					const conversationsFile = zip.file('conversations.json');
					if (!conversationsFile) {
						throw new Error('conversations.json not found in export');
					}

					const jsonText = await conversationsFile.async('text');
					conversations = JSON.parse(jsonText);
				}

				console.log('[Background] Total conversations:', conversations.length);

				// Send initial response with total count
				sendResponse({
					success: true,
					totalCount: conversations.length
				});

				// Send conversations in batches of 50
				const tabs = await chrome.tabs.query({ url: "https://claude.ai/recents*" });
				if (tabs.length === 0) {
					throw new Error('No recents tab found');
				}

				const tabId = tabs[0].id; // Just use the first one
				console.log('[Background] Sending to tab:', tabId);

				const BATCH_SIZE = 50;
				for (let i = 0; i < conversations.length; i += BATCH_SIZE) {
					const batch = conversations.slice(i, i + BATCH_SIZE);

					chrome.tabs.sendMessage(tabId, {
						type: 'GDPR_BATCH',
						batch: batch,
						index: i,
						total: conversations.length
					});

					// Small delay to avoid overwhelming
					await new Promise(resolve => setTimeout(resolve, 30));
				}

				// Signal completion
				chrome.tabs.sendMessage(tabId, {
					type: 'GDPR_COMPLETE'
				});

				console.log('[Background] All batches sent');

			} catch (error) {
				console.error('[Background] Download failed:', error);
				sendResponse({ success: false, error: error.message });
			}
		})();

		return true; // Keep channel open for async response
	}
});