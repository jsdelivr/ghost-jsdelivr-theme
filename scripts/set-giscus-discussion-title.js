const { decode } = require('html-entities');

module.exports = async ({ github, context, core }) => {
	const discussion = context.payload.discussion;
	const isAllowedPostUrl = (url) => url.protocol === 'https:'
		&& url.hostname === 'www.jsdelivr.com'
		&& url.port === ''
		&& url.pathname.startsWith('/blog/');

	if (discussion.category?.name !== 'Blog comments') {
		core.info(`Skipping discussion in category ${discussion.category?.name ?? 'unknown'}.`);
		return;
	}

	const links = discussion.body.match(/https?:\/\/[^\s<>\)]+/g) ?? [];
	const postUrl = links
		.map((link) => {
			try {
				return new URL(link);
			} catch {
				return null;
			}
		})
		.find((url) => url && isAllowedPostUrl(url));

	if (!postUrl) {
		core.setFailed('The discussion body does not contain a jsDelivr blog post URL.');
		return;
	}

	const maxRedirects = 5;
	const requestSignal = AbortSignal.timeout(15_000);
	let html;
	let response;
	let responseUrl = postUrl;

	try {
		for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
			response = await fetch(responseUrl, {
				headers: { 'User-Agent': 'jsdelivr-giscus-title-action' },
				redirect: 'manual',
				signal: requestSignal,
			});

			if (![301, 302, 303, 307, 308].includes(response.status)) {
				break;
			}

			if (redirectCount === maxRedirects) {
				core.setFailed(`Too many redirects while fetching ${postUrl}.`);
				return;
			}

			const location = response.headers.get('location');

			if (!location) {
				core.setFailed(`Received a redirect without a location while fetching ${postUrl}.`);
				return;
			}

			let redirectUrl;

			try {
				redirectUrl = new URL(location, responseUrl);
			} catch {
				core.setFailed(`Received an invalid redirect while fetching ${postUrl}.`);
				return;
			}

			if (!isAllowedPostUrl(redirectUrl)) {
				core.setFailed(`Refusing to follow redirect to ${redirectUrl}.`);
				return;
			}

			responseUrl = redirectUrl;
		}

		if (!response.ok) {
			core.setFailed(`Unable to fetch ${postUrl} (${response.status}).`);
			return;
		}

		html = await response.text();
	} catch (error) {
		core.setFailed(`Unable to fetch ${postUrl}: ${error instanceof Error ? error.message : error}.`);
		return;
	}

	const getAttribute = (tag, name) => tag?.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'))?.[2];
	const ogTitleTag = (html.match(/<meta\b[^>]*>/gi) ?? [])
		.find((tag) => getAttribute(tag, 'property')?.toLowerCase() === 'og:title');
	const encodedTitle = getAttribute(ogTitleTag, 'content')
		?? html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];

	if (!encodedTitle) {
		core.setFailed(`Unable to find a title in ${postUrl}.`);
		return;
	}

	const title = decode(encodedTitle)
		.replace(/\s+/g, ' ')
		.trim();

	if (!title || title.length > 256) {
		core.setFailed(`The resolved title has an invalid length (${title.length}).`);
		return;
	}

	const body = discussion.body.replace(/^# jsdelivr-post-[^\r\n]*/, () => `# ${title}`);

	if (body === discussion.body) {
		core.setFailed('Unable to find the generated discussion heading.');
		return;
	}

	await github.graphql(
		`mutation($body: String!, $discussionId: ID!, $title: String!) {
			updateDiscussion(input: { body: $body, discussionId: $discussionId, title: $title }) {
				discussion {
					body
					title
					url
				}
			}
		}`,
		{
			body,
			discussionId: discussion.node_id,
			title,
		},
	);

	core.info(`Renamed discussion and its heading to "${title}".`);
};
