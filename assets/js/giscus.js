(async () => {
	const loader = document.currentScript;
	const { themeUrl, ...config } = loader.dataset;
	const giscusOrigin = 'https://giscus.app';
	const shell = loader.previousElementSibling;
	const count = shell?.querySelector('.giscus-comment-count');
	let theme = 'light';

	window.addEventListener('message', (event) => {
		const frame = shell?.querySelector('.giscus-frame');
		const total = event.data?.giscus?.discussion?.totalCommentCount;

		if (!count || event.origin !== giscusOrigin || event.source !== frame?.contentWindow || !Number.isInteger(total) || total < 0) {
			return;
		}

		count.textContent = `${total} ${total === 1 ? 'comment' : 'comments'}`;
	});

	try {
		const response = await fetch(themeUrl, {
			cache: ['localhost', '127.0.0.1'].includes(window.location.hostname) ? 'no-store' : 'default',
		});

		if (!response.ok) {
			throw new Error(`Unable to load the giscus theme (${response.status}).`);
		}

		const bytes = new TextEncoder().encode(await response.text());
		let binary = '';

		for (const byte of bytes) {
			binary += String.fromCharCode(byte);
		}

		theme = `data:text/css;base64,${btoa(binary)}`;
	} catch (error) {
		console.error(error);
	}

	const script = document.createElement('script');

	for (const [key, value] of Object.entries(config)) {
		script.dataset[key] = value;
	}

	script.src = `${giscusOrigin}/client.js`;
	script.dataset.theme = theme;
	script.crossOrigin = 'anonymous';
	script.async = true;
	loader.after(script);
})();
