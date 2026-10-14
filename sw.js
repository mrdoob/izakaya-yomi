// Caches everything for offline use and adds the headers needed for
// cross-origin isolation (multithreaded WASM), which GitHub Pages can't set.

const ASSETS = [
	'./',
	'index.html',
	'style.css',
	'manifest.webmanifest',
	'icon.svg',
	'icon-192.png',
	'icon-512.png',
	'src/main.js',
	'src/ocr.js',
	'src/reading.js',
	'src/glossary.js',
	'src/dictionary.js',
	'src/fetch.js',
	'src/pwa.js',
	'src/zoom.js',
	'dict/jmdict-eng.txt.gz',
	'models/det.onnx',
	'models/rec.onnx',
	'models/rec_dict.txt',
	'vendor/ort/ort.webgpu.min.mjs',
	'vendor/ort/ort-wasm-simd-threaded.asyncify.mjs',
	'vendor/ort/ort-wasm-simd-threaded.asyncify.wasm',
	'vendor/kuromoji/kuromoji.js',
	'vendor/kuromoji/dict/base.dat.gz',
	'vendor/kuromoji/dict/cc.dat.gz',
	'vendor/kuromoji/dict/check.dat.gz',
	'vendor/kuromoji/dict/tid.dat.gz',
	'vendor/kuromoji/dict/tid_map.dat.gz',
	'vendor/kuromoji/dict/tid_pos.dat.gz',
	'vendor/kuromoji/dict/unk.dat.gz',
	'vendor/kuromoji/dict/unk_char.dat.gz',
	'vendor/kuromoji/dict/unk_compat.dat.gz',
	'vendor/kuromoji/dict/unk_invoke.dat.gz',
	'vendor/kuromoji/dict/unk_map.dat.gz',
	'vendor/kuromoji/dict/unk_pos.dat.gz'
];

// Content hash of each asset, filled in at deploy time by scripts/stamp-sw.mjs.
// Files are cached by hash, so an update only downloads the files that changed.
// Empty while developing: code then comes from the network first so edits show up.
const HASHES = {};

const STAMPED = Object.keys( HASHES ).length > 0;
const CACHE = STAMPED ? `izakaya-yomi-${ HASHES[ 'sw' ] }` : 'izakaya-yomi-dev';
const NETWORK_FIRST = /\/$|\.(html|css|js|webmanifest)$/;

function cacheKey( asset ) {

	return STAMPED ? `${ asset }?v=${ HASHES[ asset ] }` : asset;

}

// The asset a request is for (relative to the app), or null.

function assetFor( request ) {

	const scope = new URL( self.registration.scope );
	const url = new URL( request.url );
	if ( url.origin !== scope.origin || ! url.pathname.startsWith( scope.pathname ) ) return null;

	const path = url.pathname.slice( scope.pathname.length ) || './';
	return ASSETS.includes( path ) ? path : null;

}

async function broadcast( message ) {

	for ( const client of await self.clients.matchAll( { type: 'window', includeUncontrolled: true } ) ) {

		client.postMessage( message );

	}

}

// Caches everything, reporting progress to the page as files arrive.
// Files already cached by a previous version with the same hash are reused.

self.addEventListener( 'install', event => {

	event.waitUntil( ( async () => {

		const cache = await caches.open( CACHE );
		let done = 0;

		await Promise.all( ASSETS.map( async asset => {

			const key = cacheKey( asset );
			let response = STAMPED ? await caches.match( key ) : undefined;

			if ( response === undefined ) {

				response = await fetch( asset, { cache: 'no-cache' } );
				if ( ! response.ok ) throw new Error( `Failed to cache ${ asset }: ${ response.status }` );

			}

			await cache.put( key, response );
			broadcast( { type: 'cache-progress', done: ++ done, total: ASSETS.length } );

		} ) );

	} )() );

	self.skipWaiting();

} );

self.addEventListener( 'message', event => {

	if ( event.data?.type !== 'cache-status' ) return;

	event.waitUntil( ( async () => {

		const cache = await caches.open( CACHE );
		const cached = await Promise.all( ASSETS.map( asset => cache.match( cacheKey( asset ) ) ) );
		const done = cached.filter( Boolean ).length;
		event.source.postMessage( { type: 'cache-progress', done, total: ASSETS.length } );

	} )() );

} );

self.addEventListener( 'activate', event => {

	event.waitUntil(
		caches.keys()
			.then( keys => Promise.all( keys.filter( key => key !== CACHE ).map( key => caches.delete( key ) ) ) )
			.then( () => self.clients.claim() )
	);

} );

function isolate( response ) {

	if ( response.status === 0 ) return response;

	const headers = new Headers( response.headers );
	headers.set( 'Cross-Origin-Opener-Policy', 'same-origin' );
	headers.set( 'Cross-Origin-Embedder-Policy', 'require-corp' );
	headers.set( 'Cross-Origin-Resource-Policy', 'same-origin' );

	return new Response( response.body, { status: response.status, statusText: response.statusText, headers } );

}

async function networkFirst( request, key ) {

	const cache = await caches.open( CACHE );

	try {

		const response = await fetch( request );
		if ( response.ok ) cache.put( key, response.clone() );
		return response;

	} catch ( error ) {

		const cached = await cache.match( key );
		if ( cached ) return cached;
		throw error;

	}

}

async function cacheFirst( request, key ) {

	const cache = await caches.open( CACHE );
	const cached = await cache.match( key );
	if ( cached ) return cached;

	const response = await fetch( request );
	if ( response.ok ) cache.put( key, response.clone() );
	return response;

}

self.addEventListener( 'fetch', event => {

	const { request } = event;
	if ( request.method !== 'GET' ) return;

	const asset = assetFor( request );

	if ( asset === null ) {

		// Other same-origin requests still need the isolation headers.
		if ( new URL( request.url ).origin === location.origin ) event.respondWith( fetch( request ).then( isolate ) );
		return;

	}

	const key = cacheKey( asset );
	const handler = ! STAMPED && NETWORK_FIRST.test( asset ) ? networkFirst : cacheFirst;
	event.respondWith( handler( request, key ).then( isolate ) );

} );
