// Caches everything for offline use and adds the headers needed for
// cross-origin isolation (multithreaded WASM), which GitHub Pages can't set.

const CACHE = 'izakaya-yomi-v4';

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
	'dict/jmdict-eng.txt.gz',
	'models/det.onnx',
	'models/rec.onnx',
	'models/rec_dict.txt',
	'vendor/ort/ort.webgpu.min.mjs',
	'vendor/ort/ort-wasm-simd-threaded.asyncify.mjs',
	'vendor/ort/ort-wasm-simd-threaded.asyncify.wasm',
	'vendor/kuromoji/kuromoji.js',
	...[ 'base', 'cc', 'check', 'tid', 'tid_map', 'tid_pos', 'unk', 'unk_char', 'unk_compat', 'unk_invoke', 'unk_map', 'unk_pos' ]
		.map( name => `vendor/kuromoji/dict/${ name }.dat.gz` )
];

// App code is fetched from the network first so updates show up; big files come from the cache.
const NETWORK_FIRST = /\/$|\.(html|css|js|webmanifest)$/;

self.addEventListener( 'install', event => {

	event.waitUntil( caches.open( CACHE ).then( cache => cache.addAll( ASSETS ) ) );
	self.skipWaiting();

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

async function networkFirst( request ) {

	const cache = await caches.open( CACHE );

	try {

		const response = await fetch( request );
		if ( response.ok ) cache.put( request, response.clone() );
		return response;

	} catch ( error ) {

		const cached = await cache.match( request, { ignoreSearch: true } );
		if ( cached ) return cached;
		throw error;

	}

}

async function cacheFirst( request ) {

	const cache = await caches.open( CACHE );
	const cached = await cache.match( request );
	if ( cached ) return cached;

	const response = await fetch( request );
	if ( response.ok ) cache.put( request, response.clone() );
	return response;

}

self.addEventListener( 'fetch', event => {

	const { request } = event;
	const url = new URL( request.url );

	if ( request.method !== 'GET' || url.origin !== location.origin ) return;

	const handler = request.mode === 'navigate' || NETWORK_FIRST.test( url.pathname ) ? networkFirst : cacheFirst;
	event.respondWith( handler( request ).then( isolate ) );

} );
