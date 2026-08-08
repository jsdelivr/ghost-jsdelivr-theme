import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const SITE_URL = 'https://www.jsdelivr.com/blog/';
const API_URL = 'https://jsdelivr-blog.ghost.io/';
const OUTPUT_PATH = path.resolve('.ghost-local/jsdelivr-public.json');

const optionalFields = [
	'canonical_url',
	'codeinjection_foot',
	'codeinjection_head',
	'custom_excerpt',
	'custom_template',
	'meta_description',
	'meta_title',
	'og_description',
	'og_image',
	'og_title',
	'twitter_description',
	'twitter_image',
	'twitter_title',
];

const compact = object => Object.fromEntries(
	Object.entries(object).filter(([, value]) => value !== null && value !== undefined),
);

// Raw HTML imports are reparsed by Ghost and can lose card variants such as callout colors.
const toMobiledocHtmlCard = html => JSON.stringify({
	version: '0.3.1',
	atoms: [],
	cards: [['html', { html }]],
	markups: [],
	sections: [[10, 0]],
});

const fetchResponse = async (url, type) => {
	const response = await fetch(url, {
		headers: {
			'User-Agent': 'ghost-jsdelivr-theme-local-preview',
		},
		signal: AbortSignal.timeout(30_000),
	});

	if (!response.ok) {
		throw new Error(`${type} request failed with HTTP ${response.status}: ${url}`);
	}

	return response;
};

const fetchJson = async url => {
	const response = await fetchResponse(url, 'Content API');
	return response.json();
};

const apiUrl = (resource, key, includeTags = false) => {
	const url = new URL(`/ghost/api/content/${resource}/`, API_URL);
	url.searchParams.set('key', key);
	url.searchParams.set('limit', 'all');

	if (resource === 'posts' || resource === 'pages') {
		url.searchParams.set('formats', 'html');
	}

	if (includeTags) {
		url.searchParams.set('include', 'tags');
	}

	return url;
};

const mapContent = (item, type) => compact({
	id: item.id,
	title: item.title,
	slug: item.slug,
	mobiledoc: toMobiledocHtmlCard(item.html ?? ''),
	type,
	status: 'published',
	visibility: 'public',
	featured: Boolean(item.featured),
	feature_image: item.feature_image,
	created_at: item.created_at,
	updated_at: item.updated_at,
	published_at: item.published_at,
	show_title_and_feature_image: type === 'page' ? item.show_title_and_feature_image : undefined,
	...Object.fromEntries(optionalFields.map(field => [field, item[field]])),
});

const mapTag = tag => compact({
	id: tag.id,
	name: tag.name,
	slug: tag.slug,
	description: tag.description,
	feature_image: tag.feature_image,
	visibility: 'public',
	accent_color: tag.accent_color,
	meta_title: tag.meta_title,
	meta_description: tag.meta_description,
	canonical_url: tag.canonical_url,
});

const main = async () => {
	const homepageResponse = await fetchResponse(SITE_URL, 'Homepage');
	const homepage = await homepageResponse.text();
	const contentKey = homepage.match(/<script\b[^>]*\bdata-key=["']([a-f0-9]+)["']/i)?.[1];

	if (!contentKey) {
		throw new Error('The public Ghost Content API key was not found on the live homepage.');
	}

	const [postsResponse, pagesResponse, tagsResponse] = await Promise.all([
		fetchJson(apiUrl('posts', contentKey, true)),
		fetchJson(apiUrl('pages', contentKey, true)),
		fetchJson(apiUrl('tags', contentKey)),
	]);

	if (!Array.isArray(postsResponse.posts)
		|| !Array.isArray(pagesResponse.pages)
		|| !Array.isArray(tagsResponse.tags)) {
		throw new Error('The live Content API returned an unexpected response shape.');
	}

	const sourceItems = [
		...postsResponse.posts.map(item => ({ item, type: 'post' })),
		...pagesResponse.pages.map(item => ({ item, type: 'page' })),
	];
	const posts = sourceItems.map(({ item, type }) => mapContent(item, type));
	const postsMeta = sourceItems
		.filter(({ item }) => item.feature_image_alt || item.feature_image_caption)
		.map(({ item }) => compact({
			post_id: item.id,
			feature_image_alt: item.feature_image_alt,
			feature_image_caption: item.feature_image_caption,
		}));
	const postsTags = sourceItems.flatMap(({ item }) => (item.tags ?? []).map(tag => ({
		post_id: item.id,
		tag_id: tag.id,
	})));

	const fixture = {
		meta: {
			exported_on: Date.now(),
			version: '5.94.0',
		},
		data: {
			posts,
			posts_meta: postsMeta,
			tags: tagsResponse.tags.map(mapTag),
			posts_tags: postsTags,
		},
	};

	await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
	const temporaryPath = `${OUTPUT_PATH}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
	await rename(temporaryPath, OUTPUT_PATH);

	console.log(`Saved ${postsResponse.posts.length} posts, ${pagesResponse.pages.length} pages, and ${tagsResponse.tags.length} tags to ${OUTPUT_PATH}`);
};

main().catch(error => {
	console.error(`Unable to create the public Ghost fixture: ${error.message}`);
	process.exitCode = 1;
});
