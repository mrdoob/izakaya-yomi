// fetch() that reports download progress.

export async function fetchWithProgress( url, onProgress ) {

	const response = await fetch( url );
	if ( ! response.ok ) throw new Error( `Failed to load ${url}: ${response.status}` );

	const total = Number( response.headers.get( 'content-length' ) ) || 0;
	const reader = response.body.getReader();
	const chunks = [];
	let loaded = 0;

	while ( true ) {

		const { done, value } = await reader.read();
		if ( done ) break;
		chunks.push( value );
		loaded += value.length;
		onProgress( loaded, total );

	}

	const buffer = new Uint8Array( loaded );
	let offset = 0;
	for ( const chunk of chunks ) {

		buffer.set( chunk, offset );
		offset += chunk.length;

	}

	return buffer;

}
