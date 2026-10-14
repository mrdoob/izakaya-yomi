// Copies the app's files into a folder ready to publish, and stamps sw.js with
// a content hash per file so phones only re-download what changed.
//
// Usage: node scripts/build-site.mjs [output folder, default _site]

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join( path.dirname( new URL( import.meta.url ).pathname ), '..' );
const output = path.resolve( process.argv[ 2 ] ?? path.join( root, '_site' ) );

const sw = fs.readFileSync( path.join( root, 'sw.js' ), 'utf8' );
const assets = JSON.parse( sw.match( /const ASSETS = (\[[\s\S]*?\]);/ )[ 1 ].replaceAll( '\'', '"' ) );

const hash = data => crypto.createHash( 'sha256' ).update( data ).digest( 'hex' ).slice( 0, 12 );
const hashes = {};

fs.rmSync( output, { recursive: true, force: true } );

for ( const asset of assets ) {

	const file = asset === './' ? 'index.html' : asset;
	const data = fs.readFileSync( path.join( root, file ) );

	hashes[ asset ] = hash( data );

	fs.mkdirSync( path.dirname( path.join( output, file ) ), { recursive: true } );
	fs.writeFileSync( path.join( output, file ), data );

}

hashes.sw = hash( JSON.stringify( hashes ) );

const stamped = sw.replace( 'const HASHES = {};', `const HASHES = ${ JSON.stringify( hashes, null, '\t' ) };` );
if ( stamped === sw ) throw new Error( 'Could not find "const HASHES = {};" in sw.js' );

fs.writeFileSync( path.join( output, 'sw.js' ), stamped );

console.log( `${ assets.length } files → ${ path.relative( root, output ) || output } (version ${ hashes.sw })` );
