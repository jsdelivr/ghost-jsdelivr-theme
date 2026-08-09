import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ghostPort = process.env.GHOST_PORT ?? '2378';
const ghostUrl = new URL(process.env.GHOST_URL ?? `http://localhost:${ghostPort}`).origin;
const stateRoot = path.resolve('.ghost-local');
const stateDirectory = path.resolve(process.env.GHOST_STATE_DIR ?? stateRoot);
const credentialsPath = path.join(stateDirectory, 'admin.json');
const importStatePath = path.join(stateDirectory, 'import-state.json');
const fixturePath = path.resolve(process.env.GHOST_FIXTURE_PATH ?? '.ghost-local/jsdelivr-public.json');
const adminEmail = 'local@jsdelivr.test';
const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const relativeStateDirectory = path.relative(stateRoot, stateDirectory);

if (!allowedHosts.has(new URL(ghostUrl).hostname)) {
	throw new Error(`Refusing to configure a non-local Ghost instance: ${ghostUrl}`);
}

if (relativeStateDirectory.startsWith('..') || path.isAbsolute(relativeStateDirectory)) {
	throw new Error(`GHOST_STATE_DIR must stay within the ignored ${stateRoot} directory.`);
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const fetchGhost = (pathname, options = {}, timeout = 30_000) => fetch(new URL(pathname, `${ghostUrl}/`), {
	...options,
	headers: {
		'Accept-Version': 'v5.0',
		...options.headers,
	},
	signal: AbortSignal.timeout(timeout),
});

const assertOk = async (response, action) => {
	if (response.ok) {
		return response;
	}

	const body = (await response.text()).replace(/\s+/g, ' ').trim();
	throw new Error(`${action} failed with HTTP ${response.status}${body ? `: ${body}` : ''}`);
};

const waitForGhost = async () => {
	const deadline = Date.now() + 90_000;
	let lastError;

	while (Date.now() < deadline) {
		try {
			const response = await fetchGhost('/ghost/api/admin/authentication/setup/', {}, 5_000);
			await assertOk(response, 'Ghost readiness check');
			const data = await response.json();
			return Boolean(data.setup?.[0]?.status);
		} catch (error) {
			lastError = error;
			await delay(1_000);
		}
	}

	throw new Error(`Ghost did not become ready at ${ghostUrl}: ${lastError?.message ?? 'timed out'}`);
};

const readCredentials = async () => {
	try {
		const credentials = JSON.parse(await readFile(credentialsPath, 'utf8'));

		if (typeof credentials.email !== 'string' || typeof credentials.password !== 'string') {
			throw new Error('email and password must be strings');
		}

		return credentials;
	} catch (error) {
		if (error.code === 'ENOENT') {
			return null;
		}

		throw new Error(`Unable to read ${credentialsPath}: ${error.message}`);
	}
};

const createCredentials = async () => {
	const credentials = {
		email: adminEmail,
		password: `Jd1!${randomBytes(24).toString('base64url')}`,
	};

	await mkdir(stateDirectory, { recursive: true });
	await writeFile(credentialsPath, `${JSON.stringify(credentials, null, 2)}\n`, {
		encoding: 'utf8',
		mode: 0o600,
	});

	return credentials;
};

const readFixture = async () => {
	const contents = await readFile(fixturePath);
	let fixture;

	try {
		fixture = JSON.parse(contents);
	} catch (error) {
		throw new Error(`Unable to parse ${fixturePath}: ${error.message}`);
	}

	const content = fixture.data?.posts;
	const postSlugs = content
		?.filter(item => item.type === 'post' && typeof item.slug === 'string')
		.map(item => item.slug);
	const pageSlugs = content
		?.filter(item => item.type === 'page' && typeof item.slug === 'string')
		.map(item => item.slug);

	if (!postSlugs?.length) {
		throw new Error(`${fixturePath} does not contain any posts.`);
	}

	return {
		contents,
		checksum: createHash('sha256').update(JSON.stringify(fixture.data)).digest('hex'),
		pageSlugs: pageSlugs ?? [],
		postSlugs,
	};
};

const readImportState = async () => {
	try {
		const state = JSON.parse(await readFile(importStatePath, 'utf8'));

		if (!/^[a-f0-9]{64}$/.test(state.checksum)) {
			throw new Error('checksum must be a SHA-256 digest');
		}

		return state;
	} catch (error) {
		if (error.code === 'ENOENT') {
			return null;
		}

		throw new Error(`Unable to read ${importStatePath}: ${error.message}`);
	}
};

const writeImportState = async checksum => {
	await mkdir(stateDirectory, { recursive: true });
	const temporaryPath = `${importStatePath}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify({ checksum }, null, 2)}\n`, 'utf8');
	await rename(temporaryPath, importStatePath);
};

const createOwner = async credentials => {
	const response = await fetchGhost('/ghost/api/admin/authentication/setup/', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			setup: [{
				name: 'jsDelivr Local',
				email: credentials.email,
				password: credentials.password,
				blogTitle: 'jsDelivr Blog (Local)',
			}],
		}),
	});

	await assertOk(response, 'Local owner setup');
};

const signIn = async credentials => {
	const response = await fetchGhost('/ghost/api/admin/session/', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Origin: ghostUrl,
		},
		body: JSON.stringify({
			username: credentials.email,
			password: credentials.password,
		}),
	});

	await assertOk(response, 'Local Ghost sign-in');
	const setCookies = response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie')].filter(Boolean);
	const cookie = setCookies.map(value => value.split(';', 1)[0]).join('; ');

	if (!cookie) {
		throw new Error('Local Ghost sign-in did not return a session cookie.');
	}

	return cookie;
};

const adminRequest = async (cookie, pathname, options = {}) => {
	const response = await fetchGhost(pathname, {
		...options,
		headers: {
			Cookie: cookie,
			Origin: ghostUrl,
			...options.headers,
		},
	});

	return assertOk(response, `${options.method ?? 'GET'} ${pathname}`);
};

const browseContent = async (cookie, resource, parameters = {}) => {
	const query = new URLSearchParams(parameters);
	const response = await adminRequest(cookie, `/ghost/api/admin/${resource}/?${query}`);
	const data = await response.json();
	return data[resource] ?? [];
};

const browsePosts = (cookie, parameters) => browseContent(cookie, 'posts', parameters);

const findPost = async (cookie, slug) => {
	const posts = await browsePosts(cookie, {
		filter: `slug:${slug}`,
		limit: '1',
	});
	return posts[0] ?? null;
};

const getSnapshotStatus = async (cookie, fixture) => {
	const parameters = {
		fields: 'slug',
		limit: 'all',
	};
	const [localPosts, localPages] = await Promise.all([
		browseContent(cookie, 'posts', parameters),
		browseContent(cookie, 'pages', parameters),
	]);
	const localPostSlugs = new Set(localPosts.map(post => post.slug));
	const localPageSlugs = new Set(localPages.map(page => page.slug));
	const importedPosts = fixture.postSlugs.filter(slug => localPostSlugs.has(slug)).length;
	const importedPages = fixture.pageSlugs.filter(slug => localPageSlugs.has(slug)).length;

	return {
		complete: importedPosts === fixture.postSlugs.length && importedPages === fixture.pageSlugs.length,
		hasMatches: importedPosts + importedPages > 0,
	};
};

const deleteDefaultPost = async cookie => {
	const post = await findPost(cookie, 'coming-soon');

	if (post) {
		await adminRequest(cookie, `/ghost/api/admin/posts/${post.id}/`, { method: 'DELETE' });
		console.log('Deleted the default Coming soon post.');
	}
};

const importFixture = async (cookie, fixture) => {
	const form = new FormData();
	form.append('importfile', new Blob([fixture.contents], { type: 'application/json' }), path.basename(fixturePath));

	await adminRequest(cookie, '/ghost/api/admin/db/', {
		method: 'POST',
		body: form,
	});

	const deadline = Date.now() + 60_000;

	while (Date.now() < deadline) {
		if ((await getSnapshotStatus(cookie, fixture)).complete) {
			console.log(`Imported ${fixturePath}.`);
			return;
		}

		await delay(1_000);
	}

	throw new Error('The imported posts did not appear within 60 seconds.');
};

const activateTheme = async cookie => {
	await adminRequest(cookie, '/ghost/api/admin/themes/jsdelivr/activate/', { method: 'PUT' });
	console.log('Activated the jsDelivr theme.');
};

const disablePortalButton = async cookie => {
	await adminRequest(cookie, '/ghost/api/admin/settings/', {
		method: 'PUT',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			settings: [{
				key: 'portal_button',
				value: false,
			}],
		}),
	});
	console.log('Disabled the local Portal button.');
};

const verifyHomepage = async cookie => {
	const [latestPost] = await browsePosts(cookie, {
		fields: 'slug',
		filter: 'status:published+tag:-content',
		limit: '1',
		order: 'published_at desc',
	});

	if (!latestPost) {
		throw new Error('Homepage verification could not find a published local post.');
	}

	const response = await fetchGhost('/');
	await assertOk(response, 'Homepage verification');
	const homepage = await response.text();

	if (!homepage.includes(`/${latestPost.slug}/`)) {
		throw new Error(`Homepage verification could not find /${latestPost.slug}/.`);
	}
};

const main = async () => {
	console.log(`Waiting for Ghost at ${ghostUrl}...`);
	const fixture = await readFixture();
	const isSetup = await waitForGhost();
	let credentials = await readCredentials();

	if (!isSetup) {
		credentials ??= await createCredentials();
		await createOwner(credentials);
		console.log('Created the local Ghost owner.');
	} else if (!credentials) {
		throw new Error(`Ghost is already configured, but ${credentialsPath} is missing. Reset the local volume or restore its local credentials.`);
	}

	const cookie = await signIn(credentials);
	const importState = await readImportState();
	const snapshotStatus = await getSnapshotStatus(cookie, fixture);

	if (isSetup && importState && importState.checksum !== fixture.checksum) {
		throw new Error('The public fixture has changed since it was imported. Run "docker compose down -v" followed by "npm run ghost:setup" to refresh the local content.');
	}

	if (isSetup && importState && snapshotStatus.complete) {
		console.log('Public fixture is already imported; skipping import.');
	} else if (isSetup && (snapshotStatus.hasMatches || importState)) {
		throw new Error('The local content does not match a complete imported fixture. Run "docker compose down -v" followed by "npm run ghost:setup" to rebuild it.');
	} else {
		await deleteDefaultPost(cookie);
		await importFixture(cookie, fixture);
		await writeImportState(fixture.checksum);
	}

	await activateTheme(cookie);
	await disablePortalButton(cookie);
	await verifyHomepage(cookie);

	console.log(`Local Ghost is ready at ${ghostUrl}`);
	console.log(`Admin email: ${credentials.email}`);
	console.log(`Admin password: ${credentials.password}`);
	console.log(`Credentials saved to ${credentialsPath}`);
};

main().catch(error => {
	console.error(`Unable to configure local Ghost: ${error.message}`);
	process.exitCode = 1;
});
